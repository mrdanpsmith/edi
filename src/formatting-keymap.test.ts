import { describe, it, expect, beforeEach } from 'vitest'
import type { EditorView } from 'prosemirror-view'
import { createBlockEditor } from './editor'
import { proseToMarkdown } from './markdown'
import { TextSelection } from 'prosemirror-state'

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

function selectText(view: EditorView, needle: string): void {
  const { doc } = view.state
  const text = doc.textContent
  const from = text.indexOf(needle) + 1
  const to = from + needle.length
  const tr = view.state.tr.setSelection(TextSelection.create(doc, from, to))
  view.dispatch(tr)
}

describe('formatting keyboard shortcuts', () => {
  it('toggles bold with Ctrl+B', () => {
    const editor = createBlockEditor(document.body, 'hello world')
    const view = editor.getView()
    selectText(view, 'hello')

    const handled = dispatchKeydown(view, 'b', { ctrlKey: true })
    expect(handled).toBe(true)
    expect(proseToMarkdown(view.state.doc)).toContain('**hello**')
    editor.destroy()
  })

  it('toggles italic with Ctrl+I', () => {
    const editor = createBlockEditor(document.body, 'hello world')
    const view = editor.getView()
    selectText(view, 'hello')

    const handled = dispatchKeydown(view, 'i', { ctrlKey: true })
    expect(handled).toBe(true)
    expect(proseToMarkdown(view.state.doc)).toContain('*hello*')
    editor.destroy()
  })
})
