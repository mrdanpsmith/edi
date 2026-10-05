import { beforeEach, describe, expect, it } from 'vitest'
import type { EditorView } from 'prosemirror-view'
import { undoNoScroll } from 'prosemirror-history'
import { createBlockEditor } from './editor'

beforeEach(() => {
  document.body.innerHTML = ''
})

function editorOn(markdown = ''): { view: EditorView; destroy: () => void } {
  const editor = createBlockEditor(document.body, markdown)
  return { view: editor.getView(), destroy: () => editor.destroy() }
}

function type(view: EditorView, text: string): void {
  view.dispatch(view.state.tr.insertText(text))
}

function keydown(view: EditorView, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
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

function suggest(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.emoji-suggest')
}

function rows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.emoji-row'))
}

describe('emoji autocomplete in body text', () => {
  it('opens the list on `:` and filters as you type', () => {
    const { view, destroy } = editorOn()
    type(view, ':')
    expect(suggest()).not.toBeNull()
    expect(rows().length).toBeGreaterThan(0)

    type(view, 'gr')
    const top = rows()[0]!
    expect(top.querySelector('.emoji-row-name')!.textContent).toContain('grinning')
    destroy()
  })

  it('puts the emoji glyph in the row', () => {
    const { view, destroy } = editorOn()
    type(view, ':rocket')
    expect(rows()[0]!.querySelector('.emoji-row-glyph')!.textContent).toBe('🚀')
    destroy()
  })

  it('closes and keeps the typed text when a space ends the token', () => {
    const { view, destroy } = editorOn()
    type(view, ':gr')
    expect(suggest()).not.toBeNull()
    type(view, ' ')
    expect(suggest()).toBeNull()
    expect(view.state.doc.textContent).toBe(':gr ')
    destroy()
  })

  it('does not open after a word character', () => {
    const { view, destroy } = editorOn()
    type(view, '12:30')
    expect(suggest()).toBeNull()
    destroy()
  })

  it('accepts on Enter and one undo restores the query', () => {
    const { view, destroy } = editorOn()
    type(view, ':grinning')
    expect(keydown(view, 'Enter')).toBe(true)
    expect(view.state.doc.textContent).toBe('😀')
    expect(suggest()).toBeNull()

    undoNoScroll(view.state, view.dispatch)
    expect(view.state.doc.textContent).toBe(':grinning')
    destroy()
  })

  it('accepts on Tab', () => {
    const { view, destroy } = editorOn()
    type(view, ':rocket')
    expect(keydown(view, 'Tab')).toBe(true)
    expect(view.state.doc.textContent).toBe('🚀')
    destroy()
  })

  it('dismisses on Escape and leaves the query', () => {
    const { view, destroy } = editorOn()
    type(view, ':sm')
    expect(keydown(view, 'Escape')).toBe(true)
    expect(suggest()).toBeNull()
    expect(view.state.doc.textContent).toBe(':sm')
    destroy()
  })

  it('clicking a row inserts without a stray newline', () => {
    const { view, destroy } = editorOn()
    type(view, ':rocket')
    const row = rows()[0]!
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.state.doc.textContent).toBe('🚀')
    expect(view.state.doc.childCount).toBe(1)
    destroy()
  })

  it('leaves normal editing keys to the editor when no token is present', () => {
    const { view, destroy } = editorOn()
    type(view, 'hello')
    expect(suggest()).toBeNull()
    // The card is closed, so Enter is the ordinary split-paragraph key again.
    keydown(view, 'Enter')
    expect(view.state.doc.childCount).toBe(2)
    expect(view.state.doc.textContent).toBe('hello')
    destroy()
  })
})
