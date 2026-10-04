import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorView } from 'prosemirror-view'
import { NodeSelection, TextSelection } from 'prosemirror-state'
import { createBlockEditor } from './editor'
import { SELECTION_EXPAND_KEY, selectionExpandKeymap } from './selectionExpand'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 900 300"></svg>', diagramType: 'base' }),
  },
}))

beforeEach(() => {
  document.body.innerHTML = ''
})

interface TextBlock {
  pos: number
  start: number
  end: number
  text: string
}

function editorOn(markdown: string): { view: EditorView; destroy: () => void } {
  const editor = createBlockEditor(document.body, markdown)
  return { view: editor.getView(), destroy: () => editor.destroy() }
}

function textBlocks(view: EditorView): TextBlock[] {
  const out: TextBlock[] = []
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock) out.push({ pos, start: pos + 1, end: pos + node.content.size + 1, text: node.textContent })
    return true
  })
  return out
}

function caretAt(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
}

/** The document position of the first node satisfying `match`. */
function posOf(view: EditorView, match: (name: string) => boolean): number {
  let found = -1
  view.state.doc.descendants((node, pos) => {
    if (found < 0 && match(node.type.name)) found = pos
    return found < 0
  })
  return found
}

function gesture(view: EditorView, key: 'ArrowUp' | 'ArrowDown'): boolean {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true, bubbles: true })
  let handled = false
  view.someProp('handleKeyDown', (fn) => {
    if (fn(view, event)) {
      handled = true
      return true
    }
    return false
  })
  return handled
}

function selectionKey(view: EditorView): string {
  const sel = view.state.selection
  return `${sel instanceof NodeSelection ? 'N' : 'T'}:${sel.from}-${sel.to}`
}

describe('cross-block keyboard selection', () => {
  it('matches the native gesture inside a block, then crosses to the next paragraph', () => {
    const { view, destroy } = editorOn('one two three\n\nfour five')
    const blocks = textBlocks(view)
    caretAt(view, blocks[0]!.start + 3)

    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(selectionKey(view)).toBe(`T:${blocks[0]!.start + 3}-${blocks[0]!.end}`)

    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection.to).toBe(blocks[1]!.end)
    destroy()
  })

  it('snaps up to the paragraph start and then to the previous paragraph', () => {
    const { view, destroy } = editorOn('one two three\n\nfour five')
    const blocks = textBlocks(view)
    caretAt(view, blocks[1]!.start + 3)

    gesture(view, 'ArrowUp')
    expect(view.state.selection.from).toBe(blocks[1]!.start)
    gesture(view, 'ArrowUp')
    expect(view.state.selection.from).toBe(blocks[0]!.start)
    destroy()
  })

  it('crosses task-list item boundaries', () => {
    const { view, destroy } = editorOn('- [ ] first\n- [ ] second')
    const blocks = textBlocks(view)
    expect(blocks.length).toBe(2)
    caretAt(view, blocks[0]!.start + 1)

    gesture(view, 'ArrowDown')
    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection.to).toBe(blocks[1]!.end)
    destroy()
  })

  it('crosses a bullet list nested in the document', () => {
    const { view, destroy } = editorOn('- one\n- two\n- three')
    const blocks = textBlocks(view)
    caretAt(view, blocks[0]!.start + 1)

    gesture(view, 'ArrowDown')
    gesture(view, 'ArrowDown')
    gesture(view, 'ArrowDown')
    expect(view.state.selection.to).toBe(blocks[2]!.end)
    destroy()
  })

  it('adds an atomic block to the range one press at a time', () => {
    const { view, destroy } = editorOn('before\n\n---\n\nafter')
    const blocks = textBlocks(view)
    caretAt(view, blocks[0]!.start + 1)

    gesture(view, 'ArrowDown')
    expect(view.state.selection.to).toBe(blocks[0]!.end)
    // The hr is added on its own, ending at the boundary before 'after'.
    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.to).toBe(blocks[1]!.pos)
    expect(view.dom.querySelector('.edi-block-selected')).not.toBeNull()
    // Another press then adds the following paragraph.
    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection.to).toBe(blocks[1]!.end)
    destroy()
  })

  it('highlights atomic blocks inside a plain text range (e.g. a mouse selection)', () => {
    const { view, destroy } = editorOn('before\n\n---\n\nafter')
    const blocks = textBlocks(view)
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, blocks[0]!.start + 1, blocks[1]!.end),
      ),
    )
    expect(view.dom.querySelector('.edi-block-selected')).not.toBeNull()
    destroy()
  })

  it('renders bracketed atomic blocks into the copied text', () => {
    const { view, destroy } = editorOn('before\n\n---\n\nafter')
    const blocks = textBlocks(view)
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, blocks[0]!.start, blocks[1]!.end),
      ),
    )
    const { text } = view.serializeForClipboard(view.state.selection.content())
    expect(text).toContain('---')
    destroy()
  })

  it('renders a bracketed mermaid block into the copied text', () => {
    const { view, destroy } = editorOn('before\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nafter')
    const before = textBlocks(view).find((b) => b.text === 'before')!
    const after = textBlocks(view).find((b) => b.text === 'after')!
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, before.start, after.end),
      ),
    )
    const { text } = view.serializeForClipboard(view.state.selection.content())
    expect(text).toContain('```mermaid')
    expect(text).toContain('A-->B')
    destroy()
  })

  it('brackets a trailing atomic block up to the document end', () => {
    const { view, destroy } = editorOn('before\n\n---')
    const blocks = textBlocks(view)
    caretAt(view, blocks[0]!.start + 1)

    gesture(view, 'ArrowDown')
    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.to).toBe(view.state.doc.content.size)
    expect(view.dom.querySelector('.edi-block-selected')).not.toBeNull()
    destroy()
  })

  it('adds a grammar code block to the range without entering it', () => {
    const { view, destroy } = editorOn('before\n\n```js\nconst x = 1\n```\n\nafter')
    const before = textBlocks(view).find((b) => b.text === 'before')!
    const after = textBlocks(view).find((b) => b.text === 'after')!
    caretAt(view, before.start + 1)

    gesture(view, 'ArrowDown')
    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.to).toBe(after.pos)
    expect(view.dom.querySelector('.edi-block-selected')).not.toBeNull()
    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection.to).toBe(after.end)
    destroy()
  })

  it('selects into a plain fenced block as text', () => {
    const { view, destroy } = editorOn('before\n\n```\nplain code\n```\n\nafter')
    const before = textBlocks(view).find((b) => b.text === 'before')!
    const plain = textBlocks(view).find((b) => b.text === 'plain code')!
    caretAt(view, before.start + 1)

    gesture(view, 'ArrowDown')
    gesture(view, 'ArrowDown')
    expect(view.state.selection.to).toBe(plain.end)
    destroy()
  })

  it('selects a trailing code block from an empty paragraph below it', () => {
    const { view, destroy } = editorOn('text\n\n```js\nconst x = 1\n```')
    // Simulate the click-below fallback: a new empty paragraph and the caret.
    const tr = view.state.tr.insert(
      view.state.doc.content.size,
      view.state.schema.nodes.paragraph.create(),
    )
    tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1))
    view.dispatch(tr)

    expect(gesture(view, 'ArrowUp')).toBe(true)
    const sel = view.state.selection
    expect(sel).toBeInstanceOf(TextSelection)
    expect(view.dom.querySelector('.edi-block-selected')).not.toBeNull()
    const { text } = view.serializeForClipboard(sel.content())
    expect(text).toContain('const x = 1')
    expect(text).not.toContain('text')
    destroy()
  })

  it('brackets a trailing grammar code block up to the document end', () => {
    const { view, destroy } = editorOn('before\n\n```js\nconst x = 1\n```')
    const before = textBlocks(view).find((b) => b.text === 'before')!
    caretAt(view, before.start + 1)

    gesture(view, 'ArrowDown')
    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.to).toBe(view.state.doc.content.size)
    expect(view.dom.querySelector('.edi-block-selected')).not.toBeNull()
    destroy()
  })

  it('grows one range across a paragraph, table and trailing code fence', () => {
    const { view, destroy } = editorOn(
      'Intro with a [link](https://example.com) here\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```json\n{ "a": 1 }\n```',
    )
    const paragraph = textBlocks(view).find((b) => b.text.startsWith('Intro'))!
    caretAt(view, paragraph.start + 3)

    gesture(view, 'ArrowDown')
    expect(view.state.selection.to).toBe(paragraph.end)
    // Each press now adds exactly one block: the table, then the fence.
    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.to).toBe(posOf(view, (n) => n === 'code_block'))
    expect(view.dom.querySelectorAll('.edi-block-selected').length).toBe(1)
    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection.to).toBe(view.state.doc.content.size)
    expect(view.dom.querySelectorAll('.edi-block-selected').length).toBe(2)
    destroy()
  })

  it('walks whole blocks from a block selection, and back', () => {
    const { view, destroy } = editorOn('before\n\n---\n\nafter')
    const blocks = textBlocks(view)
    const hrPos = posOf(view, (name) => name === 'horizontal_rule')
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hrPos)))

    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.to).toBe(blocks[1]!.end)

    expect(gesture(view, 'ArrowUp')).toBe(true)
    expect(view.state.selection).toBeInstanceOf(NodeSelection)
    destroy()
  })

  it('retraces the exact ladder on the way back', () => {
    const { view, destroy } = editorOn('one two three\n\nfour five\n\nsix seven')
    const blocks = textBlocks(view)
    caretAt(view, blocks[0]!.start + 2)

    const forward = [selectionKey(view)]
    gesture(view, 'ArrowDown')
    forward.push(selectionKey(view))
    gesture(view, 'ArrowDown')
    forward.push(selectionKey(view))
    gesture(view, 'ArrowDown')
    forward.push(selectionKey(view))

    const back: string[] = []
    for (let i = 0; i < 3; i += 1) {
      gesture(view, 'ArrowUp')
      back.push(selectionKey(view))
    }
    expect(back).toEqual([forward[2], forward[1], forward[0]])
    destroy()
  })

  it('resets the memo when the document changes', () => {
    const { view, destroy } = editorOn('one two\n\nthree four\n\nfive six')
    const blocks = textBlocks(view)
    caretAt(view, blocks[0]!.start + 1)
    gesture(view, 'ArrowDown')
    gesture(view, 'ArrowDown')

    view.dispatch(view.state.tr.insertText('X', blocks[0]!.start))
    expect(SELECTION_EXPAND_KEY.getState(view.state)?.rungs.length ?? 0).toBe(0)
    destroy()
  })

  it('resets the memo on a plain selection change', () => {
    const { view, destroy } = editorOn('one two\n\nthree four')
    const blocks = textBlocks(view)
    caretAt(view, blocks[0]!.start + 1)
    gesture(view, 'ArrowDown')

    caretAt(view, blocks[0]!.start)
    expect(SELECTION_EXPAND_KEY.getState(view.state)?.rungs.length ?? 0).toBe(0)
    destroy()
  })

  it('starts a fresh ladder in the other direction at the base', () => {
    const { view, destroy } = editorOn('one two\n\nthree four')
    const blocks = textBlocks(view)
    caretAt(view, blocks[1]!.start + 2)
    gesture(view, 'ArrowDown')
    gesture(view, 'ArrowUp')
    // Back at the base; pressing the opposite (up) direction starts a fresh
    // ladder upward, beginning with the current paragraph's start.
    expect(gesture(view, 'ArrowUp')).toBe(true)
    expect(view.state.selection.from).toBe(blocks[1]!.start)
    destroy()
  })

  it('does not handle ordinary or differently-modified keys', () => {
    const { view, destroy } = editorOn('hello world')
    const handler = selectionExpandKeymap.props!.handleKeyDown as (
      view: EditorView,
      event: KeyboardEvent,
    ) => boolean
    const cases: Array<[string, KeyboardEventInit]> = [
      ['ArrowDown', {}],
      ['ArrowUp', {}],
      ['ArrowDown', { shiftKey: true }],
      ['ArrowLeft', { ctrlKey: true, shiftKey: true }],
      ['ArrowRight', { ctrlKey: true, shiftKey: true }],
    ]
    for (const [key, opts] of cases) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, ...opts })
      expect(handler(view, event), `${key} ${JSON.stringify(opts)}`).toBe(false)
    }
    destroy()
  })

  it('holds the selection when growing down past the document end', () => {
    const { view, destroy } = editorOn('one\n\ntwo')
    const blocks = textBlocks(view)
    caretAt(view, blocks[0]!.start + 1)
    gesture(view, 'ArrowDown')
    gesture(view, 'ArrowDown')
    const at = selectionKey(view)
    expect(view.state.selection.to).toBe(blocks[1]!.end)

    // Swallowed: if it fell through, the browser's own Ctrl+Shift+Down would
    // collapse the selection.
    expect(gesture(view, 'ArrowDown')).toBe(true)
    expect(selectionKey(view)).toBe(at)
    destroy()
  })

  it('holds the selection when growing up past the document start', () => {
    const { view, destroy } = editorOn('one\n\ntwo')
    const blocks = textBlocks(view)
    caretAt(view, blocks[1]!.start + 1)
    gesture(view, 'ArrowUp')
    gesture(view, 'ArrowUp')
    const at = selectionKey(view)
    expect(view.state.selection.from).toBe(blocks[0]!.start)

    expect(gesture(view, 'ArrowUp')).toBe(true)
    expect(selectionKey(view)).toBe(at)
    destroy()
  })

  it('collapses a selection containing a special block on a plain arrow', () => {
    const { view, destroy } = editorOn('one\n\n---\n\ntwo')
    const blocks = textBlocks(view)
    caretAt(view, blocks[0]!.start + 1)
    gesture(view, 'ArrowDown')
    gesture(view, 'ArrowDown')
    expect(view.dom.querySelector('.edi-block-selected')).not.toBeNull()

    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
    let handled = false
    view.someProp('handleKeyDown', (fn) => {
      if (fn(view, event)) {
        handled = true
        return true
      }
      return false
    })
    expect(handled).toBe(true)
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.empty).toBe(true)
    // Memo cleared: the next grow starts fresh from the collapsed caret.
    expect(SELECTION_EXPAND_KEY.getState(view.state)?.rungs.length ?? 0).toBe(0)
    destroy()
  })

  it('collapses a whole-block selection on a plain arrow', () => {
    const { view, destroy } = editorOn('before\n\n---\n\nafter')
    const hrPos = posOf(view, (n) => n === 'horizontal_rule')
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hrPos)))

    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    let handled = false
    view.someProp('handleKeyDown', (fn) => {
      if (fn(view, event)) {
        handled = true
        return true
      }
      return false
    })
    expect(handled).toBe(true)
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.selection.empty).toBe(true)
    destroy()
  })

  it('leaves a text-only selection to the browser on a plain arrow', () => {
    const { view, destroy } = editorOn('one\n\ntwo')
    const blocks = textBlocks(view)
    caretAt(view, blocks[0]!.start + 1)
    gesture(view, 'ArrowDown')

    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
    let handled = false
    view.someProp('handleKeyDown', (fn) => {
      if (fn(view, event)) {
        handled = true
        return true
      }
      return false
    })
    expect(handled).toBe(false)
    destroy()
  })

  it('no-ops at the document edges', () => {
    const { view, destroy } = editorOn('only block')
    const blocks = textBlocks(view)
    caretAt(view, blocks[0]!.start)
    expect(gesture(view, 'ArrowUp')).toBe(false)
    caretAt(view, blocks[0]!.end)
    expect(gesture(view, 'ArrowDown')).toBe(false)
    destroy()
  })
})
