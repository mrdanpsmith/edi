import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createEditor, createEditorState, restoreChangeNotifications, suppressChangeNotifications } from './editor'

describe('createEditorState', () => {
  it('creates a state holding the given document', () => {
    const state = createEditorState('# Title\n\nbody')
    expect(state.doc.toString()).toBe('# Title\n\nbody')
  })

  it('creates an empty state', () => {
    const state = createEditorState('')
    expect(state.doc.length).toBe(0)
  })
})

describe('createEditor', () => {
  let parent: HTMLElement

  beforeEach(() => {
    parent = document.createElement('div')
    document.body.appendChild(parent)
    restoreChangeNotifications()
  })

  it('creates an editor whose value mirrors the document', () => {
    const editor = createEditor(parent, () => undefined)
    expect(editor.getValue()).toBe('')
    editor.setValue('hello world')
    expect(editor.getValue()).toBe('hello world')
    editor.setValue('')
    expect(editor.getValue()).toBe('')
  })

  it('notifies the change handler on user changes', () => {
    const onChange = vi.fn()
    const editor = createEditor(parent, onChange)
    editor.view.dispatch({
      changes: { from: 0, insert: 'typed text' },
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(editor.view)
  })

  it('does not notify when setValue is used', () => {
    const onChange = vi.fn()
    const editor = createEditor(parent, onChange)
    editor.setValue('from outside')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not notify while change notifications are suppressed', () => {
    const onChange = vi.fn()
    const editor = createEditor(parent, onChange)
    suppressChangeNotifications()
    editor.view.dispatch({
      changes: { from: 0, insert: 'x' },
    })
    restoreChangeNotifications()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('focuses the editor', () => {
    const editor = createEditor(parent, () => undefined)
    expect(() => editor.focus()).not.toThrow()
  })
})
