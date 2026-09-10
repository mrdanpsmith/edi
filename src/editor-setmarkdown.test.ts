import { describe, expect, it, beforeEach } from 'vitest'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { createBlockEditor } from './editor'
import { getSourceBlockState, toggleSourceMode } from './blockplugin'

function createEditor(initialMarkdown: string) {
  const doc = markdownToProse(initialMarkdown, schema)
  const view = new EditorView(document.body, {
    state: EditorState.create({ doc }),
  })
  return view
}

function setMarkdown(view: EditorView, markdown: string) {
  const newDoc = markdownToProse(markdown, view.state.schema)
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('editor setMarkdown round-trip', () => {
  it('setMarkdown("") clears the editor', () => {
    const view = createEditor('# Welcome\n\nHello world')
    // Verify content is there
    expect(proseToMarkdown(view.state.doc)).toContain('Welcome')

    // Clear it
    setMarkdown(view, '')
    const result = proseToMarkdown(view.state.doc)
    expect(result.trim()).toBe('')
    view.destroy()
  })

  it('full new-tab flow: set content then set empty', () => {
    const view = createEditor('# Welcome\n\nHello world')
    expect(proseToMarkdown(view.state.doc)).toContain('Welcome')

    // Simulate what addSession does: snapshot, then setMarkdown('')
    setMarkdown(view, '')

    // The editor MUST be empty now
    const afterEmpty = proseToMarkdown(view.state.doc)
    expect(afterEmpty.trim()).toBe('')
    expect(view.state.doc.textContent).toBe('')
    view.destroy()
  })

  it('setMarkdown with new content replaces old content entirely', () => {
    const view = createEditor('# Welcome\n\nHello world')
    setMarkdown(view, '# New Doc\n\nDifferent content')
    const result = proseToMarkdown(view.state.doc)
    expect(result).toContain('New Doc')
    expect(result).not.toContain('Welcome')
    expect(result).not.toContain('Hello world')
    view.destroy()
  })
})

describe('source mode is scoped to a single document', () => {
  function firstBlockPos(view: import('prosemirror-view').EditorView): number {
    let pos = -1
    view.state.doc.forEach((_node, offset) => {
      if (pos < 0) pos = offset
    })
    return pos
  }

  it('setMarkdown releases a source-mode block across tabs', () => {
    const editor = createBlockEditor(document.body, '# First\n\nSecond paragraph')
    const view = editor.getView()
    const pos = firstBlockPos(view)

    view.dispatch(toggleSourceMode(view.state, pos))
    expect(getSourceBlockState(view.state).sourceBlockPos).toBe(pos)

    // Simulate activating a different tab: the whole document is swapped.
    editor.setMarkdown('# Other doc\n\nMore content')

    // The lock must not leak into the other document.
    expect(getSourceBlockState(view.state).sourceBlockPos).toBeNull()

    // And opening the editor in the new document must work again.
    view.dispatch(toggleSourceMode(view.state, pos))
    expect(getSourceBlockState(view.state).sourceBlockPos).toBe(pos)
    editor.destroy()
  })

  it('commitSource releases source mode at a tab boundary', () => {
    const editor = createBlockEditor(document.body, '# First\n\nSecond paragraph')
    const view = editor.getView()
    const pos = firstBlockPos(view)

    view.dispatch(toggleSourceMode(view.state, pos))
    expect(getSourceBlockState(view.state).sourceBlockPos).toBe(pos)

    expect(editor.commitSource()).toBe(true)
    expect(getSourceBlockState(view.state).sourceBlockPos).toBeNull()
    expect(view.state.doc.child(0).attrs._source).toBe(false)
    editor.destroy()
  })
})
