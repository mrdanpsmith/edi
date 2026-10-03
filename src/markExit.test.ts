import { describe, expect, it, beforeEach } from 'vitest'
import type { EditorView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import { createBlockEditor } from './editor'
import { proseToMarkdown } from './markdown'

beforeEach(() => {
  document.body.innerHTML = ''
})

function dispatchKeydown(view: EditorView, key: string, opts: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...opts })
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

function typeText(view: EditorView, text: string): void {
  for (const char of text) {
    const { from, to } = view.state.selection
    let handled = false
    view.someProp('handleTextInput', (fn) => {
      if (fn(view, from, to, char, () => view.state.tr)) handled = true
    })
    if (!handled) {
      view.dispatch(view.state.tr.insertText(char))
    }
  }
}

/** The start of the `index`th text block, as a document position. */
function blockStart(view: EditorView, index = 0): number {
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock && ++at === index) {
      at = pos + 1
      return false
    }
    return at < 0
  })
  return at
}

/** Put the caret `offset` characters into the text block at `index`. */
function caretAt(view: EditorView, offset: number, index = 0): void {
  const from = blockStart(view, index) + offset
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from)))
}

/** Put the caret at the end of the text block whose text is `text`. */
function caretEndOf(view: EditorView, text: string): void {
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === text) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + node.nodeSize - 1)))
      return false
    }
    return true
  })
}

/** A loaded editor, its view, and the markdown it would save. */
function editorOn(markdown: string): { view: EditorView; markdown: () => string; destroy: () => void } {
  const editor = createBlockEditor(document.body, markdown)
  return {
    view: editor.getView(),
    markdown: () => proseToMarkdown(editor.getView().state.doc).trim(),
    destroy: () => editor.destroy(),
  }
}

describe('leaving an inline mark with an arrow key', () => {
  it('ArrowRight at the end of the last block leaves the mark', () => {
    const { view, markdown, destroy } = editorOn('**bold**')
    caretAt(view, 4)

    expect(dispatchKeydown(view, 'ArrowRight')).toBe(true)
    // Nothing in the document changed: only what the next character inherits.
    expect(markdown()).toBe('**bold**')
    typeText(view, ' and more')
    expect(markdown()).toBe('**bold** and more')
    destroy()
  })

  it('ArrowLeft at the start of the first block leaves the mark', () => {
    const { view, markdown, destroy } = editorOn('**bold**')
    caretAt(view, 0)

    expect(dispatchKeydown(view, 'ArrowLeft')).toBe(true)
    typeText(view, 'say ')
    expect(markdown()).toBe('say **bold**')
    destroy()
  })

  it('leaves only the innermost mark, so bold carries on past the code span', () => {
    const { view, markdown, destroy } = editorOn('**a `code`**')
    caretAt(view, 'a code'.length)

    expect(dispatchKeydown(view, 'ArrowRight')).toBe(true)
    typeText(view, 'b')
    expect(markdown()).toBe('**a `code`b**')
    destroy()
  })

  it('leaves a mark the document already had, not one being typed', () => {
    const { view, markdown, destroy } = editorOn('a `code`')
    caretAt(view, 'a code'.length)

    expect(dispatchKeydown(view, 'ArrowRight')).toBe(true)
    typeText(view, ' and more')
    expect(markdown()).toBe('a `code` and more')
    destroy()
  })

  it('does not handle the arrow where a character on that side is outside the mark', () => {
    const { view, markdown, destroy } = editorOn('`code` tail')
    caretAt(view, 4)

    expect(dispatchKeydown(view, 'ArrowRight')).toBe(false)
    expect(markdown()).toBe('`code` tail')
    destroy()
  })

  it('does not handle the arrow in the middle of a run', () => {
    const { view, markdown, destroy } = editorOn('**bold**')
    caretAt(view, 2)

    expect(dispatchKeydown(view, 'ArrowRight')).toBe(false)
    expect(dispatchKeydown(view, 'ArrowLeft')).toBe(false)
    expect(markdown()).toBe('**bold**')
    destroy()
  })

  it('leaves the arrow alone when another block follows, so it still moves', () => {
    const { view, markdown, destroy } = editorOn('**bold**\n\nplain')
    caretAt(view, 4)

    expect(dispatchKeydown(view, 'ArrowRight')).toBe(false)
    expect(markdown()).toBe('**bold**\n\nplain')
    destroy()
  })

  it('leaves the arrow alone when a block comes before, so it still moves', () => {
    const { view, destroy } = editorOn('plain\n\n**bold**')
    caretAt(view, 4, 1)

    expect(dispatchKeydown(view, 'ArrowLeft')).toBe(false)
    destroy()
  })

  it('leaves the mark at the end of the last list item', () => {
    const { view, markdown, destroy } = editorOn('- one\n- **two**')
    caretEndOf(view, 'two')

    expect(dispatchKeydown(view, 'ArrowRight')).toBe(true)
    typeText(view, '!')
    expect(markdown()).toBe('- one\n- **two**!')
    destroy()
  })

  it('leaves the arrow alone between list items', () => {
    const { view, destroy } = editorOn('- **one**\n- two')
    caretEndOf(view, 'one')

    expect(dispatchKeydown(view, 'ArrowRight')).toBe(false)
    destroy()
  })

  it('ignores a selection, and an arrow with a modifier held', () => {
    const { view, markdown, destroy } = editorOn('**bold**')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)))

    expect(dispatchKeydown(view, 'ArrowRight')).toBe(false)
    caretAt(view, 4)
    for (const opts of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(dispatchKeydown(view, 'ArrowRight', opts)).toBe(false)
      expect(dispatchKeydown(view, 'ArrowLeft', opts)).toBe(false)
    }
    expect(markdown()).toBe('**bold**')
    destroy()
  })

  it('ignores plain text, where there is no mark to leave', () => {
    const { view, destroy } = editorOn('just words')
    caretAt(view, 10)

    expect(dispatchKeydown(view, 'ArrowRight')).toBe(false)
    destroy()
  })

  it('ignores arrows inside a code block', () => {
    const { view, destroy } = editorOn('```\nplain\n```')
    let from = 0
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'code_block') from = pos + node.nodeSize - 2
      return true
    })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from)))

    expect(dispatchKeydown(view, 'ArrowRight')).toBe(false)
    expect(dispatchKeydown(view, 'ArrowLeft')).toBe(false)
    destroy()
  })

  it('pressing it twice changes nothing more than the first press did', () => {
    const { view, markdown, destroy } = editorOn('**bold**')
    caretAt(view, 4)

    dispatchKeydown(view, 'ArrowRight')
    expect(dispatchKeydown(view, 'ArrowRight')).toBe(true)
    typeText(view, '!')
    expect(markdown()).toBe('**bold**!')
    destroy()
  })
})

describe('a closing delimiter leaves its mark', () => {
  function typeInto(typed: string): string {
    const editor = createBlockEditor(document.body, '')
    const view = editor.getView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    typeText(view, typed)
    const out = proseToMarkdown(view.state.doc).trim()
    editor.destroy()
    return out
  }

  it.each([
    ['**bold**'],
    ['*em*'],
    ['`code`'],
    ['~~strike~~'],
    ['==mark=='],
    ['~sub~'],
    ['^sup^'],
  ])('types %s then plain text', delimiters => {
    expect(typeInto(`${delimiters}plain`)).toBe(`${delimiters}plain`)
  })

  it('leaves a mark the span was nested in', () => {
    const editor = createBlockEditor(document.body, '')
    const view = editor.getView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    typeText(view, 'a **b**')

    expect(proseToMarkdown(view.state.doc).trim()).toBe('a **b**')
    typeText(view, 'c')
    expect(proseToMarkdown(view.state.doc).trim()).toBe('a **b**c')
    editor.destroy()
  })

  it('does not fire a rule inside a longer run of its own delimiter', () => {
    // `~~strike~` is a match for the subscript pattern's tail, and used to be
    // a subscript: the run of `~` belongs to strikethrough until it closes.
    expect(typeInto('~~strike~~')).toBe('~~strike~~')
    expect(typeInto('a==b==c')).toBe('a==b==c')
  })
})