import { describe, expect, it, beforeEach, vi } from 'vitest'
import { undo } from 'prosemirror-history'
import { TextSelection } from 'prosemirror-state'
import { createBlockEditor } from './editor'
import { proseToMarkdown } from './markdown'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('replaceMarkdown', () => {
  it('replaces the whole document', () => {
    const editor = createBlockEditor(document.body, '# Now\n\nThe current text.')
    editor.replaceMarkdown('# Then\n\nAn older text.')
    expect(editor.getMarkdown().trim()).toBe('# Then\n\nAn older text.')
    editor.destroy()
  })

  it('is one undoable edit, unlike setMarkdown', () => {
    const editor = createBlockEditor(document.body, 'The current text.')
    const view = editor.getView()
    editor.replaceMarkdown('An older text.')
    // Applied to the state rather than dispatched: an undo scrolls the
    // selection into view, which jsdom cannot measure.
    let undone = view.state
    expect(undo(view.state, (tr) => { undone = view.state.apply(tr) })).toBe(true)
    expect(proseToMarkdown(undone.doc).trim()).toBe('The current text.')
    editor.destroy()
  })

  it('replaces only what differs, so a caret outside the change stays put', () => {
    const editor = createBlockEditor(document.body, 'First paragraph.\n\nSecond paragraph.')
    const view = editor.getView()
    // The caret inside "First".
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)))
    editor.replaceMarkdown('First paragraph.\n\nSecond paragraph, edited by an agent.')
    expect(view.state.selection.from).toBe(3)
    expect(editor.getMarkdown().trim()).toBe('First paragraph.\n\nSecond paragraph, edited by an agent.')
    editor.destroy()
  })

  it('does nothing when the text is the document already', () => {
    const onChange = vi.fn()
    const editor = createBlockEditor(document.body, 'Same.', { onChange })
    editor.replaceMarkdown('Same.')
    expect(onChange).not.toHaveBeenCalled()
    editor.destroy()
  })

  it('is a change: the document leaves its saved point and onChange fires', () => {
    const onChange = vi.fn()
    const editor = createBlockEditor(document.body, 'The current text.', { onChange })
    expect(editor.isAtSavedPoint()).toBe(true)
    editor.replaceMarkdown('An older text.')
    expect(onChange).toHaveBeenCalled()
    expect(editor.isAtSavedPoint()).toBe(false)
    editor.destroy()
  })
})
