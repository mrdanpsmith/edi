import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { EditorView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import { Slice } from 'prosemirror-model'
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

function cursorInsideLastBlock(view: EditorView, offset = 0): void {
  const { doc } = view.state
  const pos = Math.max(0, doc.content.size - 1 - offset)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, pos)))
}

function hasNode(view: EditorView, name: string): boolean {
  let found = false
  view.state.doc.descendants((node) => {
    if (node.type.name === name) found = true
  })
  return found
}

function textMarks(view: EditorView): string[] {
  const marks = new Set<string>()
  view.state.doc.descendants((node) => {
    if (node.isText) {
      for (const m of node.marks) marks.add(m.type.name)
    }
  })
  return [...marks]
}

describe('input rules', () => {
  it('turns "# " into a heading via incremental typing', () => {
    const editor = createBlockEditor(document.body, '')
    const view = editor.getView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 0)))
    typeText(view, '# Hello')
    expect(hasNode(view, 'heading')).toBe(true)
    expect(view.state.doc.textContent).toBe('Hello')
    editor.destroy()
  })

  it('turns --- into a horizontal rule', () => {
    const editor = createBlockEditor(document.body, '')
    const view = editor.getView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 0)))
    typeText(view, '---')
    expect(hasNode(view, 'horizontal_rule')).toBe(true)
    editor.destroy()
  })

  it.each([
    ['**bold**', 'strong', 'bold'],
    ['*em*', 'em', 'em'],
    ['`code`', 'code', 'code'],
    ['~~strike~~', 'strikethrough', 'strike'],
  ])('turns %s into a %s mark', (typed, mark, inner) => {
    const editor = createBlockEditor(document.body, '')
    const view = editor.getView()
    const { from } = view.state.selection
    let handled = false
    view.someProp('handleTextInput', (fn) => {
      if (fn(view, from, from, typed, () => view.state.tr)) handled = true
    })
    expect(handled).toBe(true)
    expect(textMarks(view)).toContain(mark)
    expect(view.state.doc.textContent).toBe(inner)
    editor.destroy()
  })
})

describe('undo/redo keymap', () => {
  it('undoes with Mod-z and redoes with Mod-Shift-z / Mod-y', () => {
    const editor = createBlockEditor(document.body, '')
    const view = editor.getView()
    view.dispatch(view.state.tr.insertText('hello'))
    expect(view.state.doc.textContent).toBe('hello')

    expect(dispatchKeydown(view, 'z', { ctrlKey: true })).toBe(true)
    expect(view.state.doc.textContent).toBe('')

    expect(dispatchKeydown(view, 'z', { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(view.state.doc.textContent).toBe('hello')

    // Mod-y is an alias for redo; nothing left to redo so it resolves false.
    expect(dispatchKeydown(view, 'y', { ctrlKey: true })).toBe(false)
    expect(view.state.doc.textContent).toBe('hello')
    editor.destroy()
  })
})

describe('list keymap', () => {
  it('lifts an empty list item with a second Backspace', () => {
    const editor = createBlockEditor(document.body, '- x')
    const view = editor.getView()
    cursorInsideLastBlock(view)
    // First Backspace deletes the text via the base keymap...
    expect(dispatchKeydown(view, 'Backspace')).toBe(true)
    // ...the second Backspace lifts the empty item out of the list.
    expect(dispatchKeydown(view, 'Backspace')).toBe(true)
    expect(proseToMarkdown(view.state.doc)).not.toContain('- ')
    editor.destroy()
  })

  it('splits a list item with Enter', () => {
    const editor = createBlockEditor(document.body, '- abc')
    const view = editor.getView()
    const doc = view.state.doc
    // Cursor just before the final 'c' (the text node starts at pos 3).
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 5)))
    expect(dispatchKeydown(view, 'Enter')).toBe(true)
    expect(view.state.doc.firstChild?.childCount).toBe(2)
    expect(view.state.doc.textContent).toBe('abc')
    expect(proseToMarkdown(view.state.doc)).toContain('- ab')
    expect(proseToMarkdown(view.state.doc)).toContain('- c')
    editor.destroy()
  })

  it('returns false for Backspace mid-paragraph (native delete only runs in the browser)', () => {
    const editor = createBlockEditor(document.body, 'plain')
    const view = editor.getView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))
    expect(dispatchKeydown(view, 'Backspace')).toBe(false)
    expect(view.state.doc.textContent).toBe('plain')
    editor.destroy()
  })

  it('toggles a task list item with Mod-Shift-x', () => {
    const editor = createBlockEditor(document.body, '- [ ] task')
    const view = editor.getView()
    cursorInsideLastBlock(view, 1)
    expect(dispatchKeydown(view, 'x', { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(proseToMarkdown(view.state.doc)).toContain('- [x]')
    editor.destroy()
  })
})

describe('block source toggle keymap', () => {
  it('enters source mode with Mod-Shift-e and commits with Escape', () => {
    const editor = createBlockEditor(document.body, 'hello')
    const view = editor.getView()
    cursorInsideLastBlock(view)

    expect(dispatchKeydown(view, 'e', { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(view.state.doc.firstChild?.attrs._source).toBe(true)

    expect(dispatchKeydown(view, 'Escape')).toBe(true)
    expect(view.state.doc.firstChild?.attrs._source).toBe(false)
    editor.destroy()
  })

  it('re-entering Mod-Shift-e in source mode commits the source', () => {
    const editor = createBlockEditor(document.body, 'hello')
    const view = editor.getView()
    cursorInsideLastBlock(view)
    dispatchKeydown(view, 'e', { ctrlKey: true, shiftKey: true })
    expect(dispatchKeydown(view, 'e', { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(view.state.doc.firstChild?.attrs._source).toBe(false)
    editor.destroy()
  })

  it('returns false when the selection is not inside a block', () => {
    const editor = createBlockEditor(document.body, 'xx')
    const view = editor.getView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size)))
    expect(dispatchKeydown(view, 'e', { ctrlKey: true, shiftKey: true })).toBe(false)
    editor.destroy()
  })

  it('returns false for Escape outside source mode', () => {
    const editor = createBlockEditor(document.body, 'hi')
    const view = editor.getView()
    expect(dispatchKeydown(view, 'Escape')).toBe(false)
    editor.destroy()
  })
})

describe('url paste plugin', () => {
  function pasteEvent(
    types: string[],
    text: string,
  ): { clipboardData: { types: string[]; getData: () => string }; preventDefault: ReturnType<typeof vi.fn> } {
    return {
      clipboardData: { types, getData: () => text },
      preventDefault: vi.fn(),
    }
  }

  function dispatchPaste(view: EditorView, event: unknown): boolean {
    let handled = false
    view.someProp('handlePaste', (fn) => {
      if (fn(view, event as ClipboardEvent, Slice.empty)) handled = true
    })
    return handled
  }

  it('links raw URLs pasted as plain text', () => {
    const editor = createBlockEditor(document.body, '')
    const view = editor.getView()
    const event = pasteEvent(['text/plain'], 'https://example.com/path')
    expect(dispatchPaste(view, event)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(proseToMarkdown(view.state.doc)).toContain('(https://example.com/path)')
    editor.destroy()
  })

  it('leaves rich-text pastes to ProseMirror', () => {
    const editor = createBlockEditor(document.body, '')
    const view = editor.getView()
    const event = pasteEvent(['text/plain', 'text/html'], 'https://example.com')
    expect(dispatchPaste(view, event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    editor.destroy()
  })

  it('ignores plain text without a URL', () => {
    const editor = createBlockEditor(document.body, '')
    const view = editor.getView()
    const event = pasteEvent([], 'just words')
    expect(dispatchPaste(view, event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    editor.destroy()
  })

  it('returns false when there is no clipboard data', () => {
    const editor = createBlockEditor(document.body, '')
    const view = editor.getView()
    expect(dispatchPaste(view, { preventDefault: vi.fn() })).toBe(false)
    editor.destroy()
  })
})

describe('link edge cases', () => {
  it('does not open a link when the click lands on a non-text child', () => {
    const editor = createBlockEditor(document.body, '[label](https://example.com)\n\n')
    const view = editor.getView()
    let handled = false
    view.someProp('handleClick', (fn) => {
      handled = fn(view, 0, new MouseEvent('click')) ?? false
    })
    expect(handled).toBe(false)
    editor.destroy()
  })

  it('merges adjacent link text nodes into one misleading-link run', () => {
    const editor = createBlockEditor(document.body, 'x')
    const view = editor.getView()
    const { doc, schema } = view.state
    const linked = schema.marks.link.create({ href: 'https://evil.example', title: null })
    const paragraph = schema.nodes.paragraph.create(null, [
      schema.text('https://google.com/', [linked]),
      schema.text('x', [linked]),
    ])
    const newDoc = schema.nodes.doc.create(null, [paragraph])
    view.dispatch(view.state.tr.replaceWith(0, doc.content.size, newDoc.content))
    const decorated = view.dom.querySelector('.ml-misleading')
    expect(decorated).not.toBeNull()
    expect(decorated?.textContent).toBe('https://google.com/x')
    editor.destroy()
  })
})

describe('BlockEditor public API', () => {
  it('getMarkdown round-trips the document', () => {
    const editor = createBlockEditor(document.body, '# Title\n\nBody')
    expect(editor.getMarkdown()).toContain('# Title')
    expect(editor.getMarkdown()).toContain('Body')
    editor.destroy()
  })

  it('resolveImages runs without images present', () => {
    const resolveImageSrc = vi.fn((src: string) => src)
    const editor = createBlockEditor(document.body, 'no images here', { resolveImageSrc })
    editor.resolveImages()
    expect(resolveImageSrc).not.toHaveBeenCalled()
    editor.destroy()
  })

  it('focuses the editor view', () => {
    const editor = createBlockEditor(document.body, 'hello')
    expect(() => editor.focus()).not.toThrow()
    editor.destroy()
  })

  it('notifies onChange when a user transaction changes the document', () => {
    const onChange = vi.fn()
    const editor = createBlockEditor(document.body, 'hello', { onChange })
    const view = editor.getView()
    view.dispatch(view.state.tr.insertText(
      '!',
      view.state.doc.content.size - 1,
      view.state.doc.content.size - 1,
    ))
    expect(onChange).toHaveBeenCalledTimes(1)
    editor.destroy()
  })

  it('does not notify onChange for selection-only transactions', () => {
    const onChange = vi.fn()
    const editor = createBlockEditor(document.body, 'hello', { onChange })
    const view = editor.getView()
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)))
    expect(onChange).not.toHaveBeenCalled()
    editor.destroy()
  })

  it('does not notify onChange for setMarkdown (tab switches)', () => {
    const onChange = vi.fn()
    const editor = createBlockEditor(document.body, 'hello', { onChange })
    editor.setMarkdown('replaced')
    expect(onChange).not.toHaveBeenCalled()
    editor.destroy()
  })

  it('notifies onChange for insertMarkdown', () => {
    const onChange = vi.fn()
    const editor = createBlockEditor(document.body, 'hello', { onChange })
    editor.insertMarkdown(' world')
    expect(onChange).toHaveBeenCalled()
    editor.destroy()
  })
})