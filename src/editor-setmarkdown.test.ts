import { describe, expect, it, beforeEach } from 'vitest'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'

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
